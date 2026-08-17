/**
 * The curated Python toolkit catalog (config/sandboxPackages.js).
 *
 * The catalog is the single source of truth behind two consumers that must
 * never disagree: `npm run sandbox-python` installs from it, and the sandbox
 * probe asks the interpreter about the same import names. These tests pin
 * that contract, the bundle-selection rules (core is never droppable, a typo
 * is reported instead of silently shrinking the toolkit), and the validation
 * that keeps operator-supplied extras from turning into pip flags.
 */

const sandboxPackages = require('../config/sandboxPackages');

const {
    BUNDLES, DEFAULT_BUNDLES, bundleNames, bundleSummary,
    resolveBundles, packagesFor, parseExtraPackages, probeModules
} = sandboxPackages;

describe('the catalog', () => {
    test('every package declares both the pip name and the import name', () => {
        for (const [name, bundle] of Object.entries(BUNDLES)) {
            expect(bundle.summary).toEqual(expect.any(String));
            expect(bundle.packages.length).toBeGreaterThan(0);
            expect(bundleSummary(name)).toBe(bundle.summary);
            for (const pkg of bundle.packages) {
                expect(typeof pkg.pip).toBe('string');
                expect(typeof pkg.module).toBe('string');
                expect(pkg.pip).not.toBe('');
                expect(pkg.module).not.toBe('');
            }
        }
    });

    test('the toolkit covers the simulation staples and the astronomy work', () => {
        const pips = packagesFor(bundleNames()).map(pkg => pkg.pip);
        expect(pips).toEqual(expect.arrayContaining([
            'numpy', 'scipy', 'matplotlib', 'pandas', 'pillow', 'sympy', 'networkx',
            'astropy', 'photutils', 'specutils', 'reproject',
            'scikit-image', 'imageio', 'h5py'
        ]));
        // pip name != import name for these two, and the probe uses the latter
        expect(probeModules()).toEqual(expect.arrayContaining(['PIL', 'skimage']));
        expect(probeModules()).not.toContain('pillow');
    });

    test('no package appears in two bundles', () => {
        const pips = bundleNames().flatMap(name => packagesFor([name]).map(pkg => pkg.pip));
        expect(new Set(pips).size).toBe(pips.length);
    });
});

describe('bundle selection', () => {
    test('an unset selection means the whole catalog', () => {
        for (const empty of [undefined, null, '', [], '   ']) {
            expect(resolveBundles(empty)).toEqual({ bundles: [...DEFAULT_BUNDLES], unknown: [] });
        }
    });

    test('a subset is honoured, in catalog order, and always includes core', () => {
        expect(resolveBundles('astro').bundles).toEqual(['core', 'astro']);
        expect(resolveBundles(['imaging', 'astro']).bundles).toEqual(['core', 'astro', 'imaging']);
        expect(resolveBundles('core').bundles).toEqual(['core']);
    });

    test('"all" and repeated names resolve to the full catalog exactly once', () => {
        expect(resolveBundles('all').bundles).toEqual([...DEFAULT_BUNDLES]);
        expect(resolveBundles('astro, astro ASTRO').bundles).toEqual(['core', 'astro']);
    });

    test('an unknown bundle is reported rather than quietly ignored', () => {
        const resolved = resolveBundles('astro,jwst-pipeline');
        expect(resolved.bundles).toEqual(['core', 'astro']);
        expect(resolved.unknown).toEqual(['jwst-pipeline']);
    });

    test('packagesFor de-duplicates and tolerates unknown bundle names', () => {
        expect(packagesFor(['core', 'core'])).toEqual(packagesFor(['core']));
        expect(packagesFor(['nope'])).toEqual([]);
        expect(packagesFor(undefined)).toEqual([]);
    });
});

describe('operator-supplied extras', () => {
    test('a bare name is both the pip and the import name', () => {
        expect(parseExtraPackages('emcee')).toEqual([{ pip: 'emcee', module: 'emcee' }]);
    });

    test('pip:import pairs are kept apart, and dashes become underscores', () => {
        expect(parseExtraPackages(['pyyaml:yaml', 'astropy-healpix']))
            .toEqual([
                { pip: 'pyyaml', module: 'yaml' },
                { pip: 'astropy-healpix', module: 'astropy_healpix' }
            ]);
    });

    test('anything that is not a plausible package name is dropped, never handed to pip', () => {
        expect(parseExtraPackages([
            '--index-url=http://evil.example',
            '-r requirements.txt',
            'astropy; rm -rf /',
            '../../etc/passwd',
            ''
        ])).toEqual([]);
    });

    test('duplicates collapse and extras join the probe list', () => {
        const extras = parseExtraPackages('emcee emcee');
        expect(extras).toHaveLength(1);
        const probed = probeModules(extras);
        expect(probed).toContain('emcee');
        expect(probed.filter(m => m === 'emcee')).toHaveLength(1);
        // An extra that duplicates a curated module does not double up either
        expect(probeModules(parseExtraPackages('numpy')).filter(m => m === 'numpy')).toHaveLength(1);
    });
});

describe('config wiring (config/sandboxConfig.js)', () => {
    const load = (sandbox, env = {}) => {
        let mod;
        const saved = {};
        for (const [key, value] of Object.entries(env)) {
            saved[key] = process.env[key];
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        try {
            jest.isolateModules(() => {
                jest.doMock('../config.json', () => ({ sandbox }), { virtual: true });
                mod = require('../config/sandboxConfig');
            });
        } finally {
            for (const [key, value] of Object.entries(saved)) {
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
            }
        }
        return mod;
    };

    test('nothing configured installs the whole catalog and no extras', () => {
        const cfg = load({}, { GOOBSTER_SANDBOX_PYTHON_BUNDLES: undefined, GOOBSTER_SANDBOX_PYTHON_EXTRAS: undefined });
        expect(cfg.pythonBundles).toEqual([...DEFAULT_BUNDLES]);
        expect(cfg.extraPythonPackages).toEqual([]);
    });

    test('config.json pins a subset and adds extras', () => {
        const cfg = load({ pythonBundles: ['astro'], extraPythonPackages: ['pyyaml:yaml'] },
            { GOOBSTER_SANDBOX_PYTHON_BUNDLES: undefined, GOOBSTER_SANDBOX_PYTHON_EXTRAS: undefined });
        expect(cfg.pythonBundles).toEqual(['core', 'astro']);
        expect(cfg.extraPythonPackages).toEqual([{ pip: 'pyyaml', module: 'yaml' }]);
    });

    test('the environment wins over config.json', () => {
        const cfg = load({ pythonBundles: ['astro'] }, { GOOBSTER_SANDBOX_PYTHON_BUNDLES: 'core' });
        expect(cfg.pythonBundles).toEqual(['core']);
    });
});
