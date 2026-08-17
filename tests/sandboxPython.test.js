/**
 * The sandbox Python toolset (managed venv + package probe).
 *
 * Three layers keep "import numpy" from dying on a bare host:
 *  1. config/sandboxConfig.js auto-detects the managed toolkit venv
 *     (data/sandbox/venv, created by `npm run sandbox-python`) as the
 *     default interpreter when none is configured explicitly.
 *  2. services/sandboxService.js probes (once) which curated third-party
 *     modules the interpreter can import and renders an honest environment
 *     note for the tool descriptions.
 *  3. utils/toolsRegistry.js appends that note to the runCode/observatory
 *     definitions and to the result of any python run that failed with a
 *     ModuleNotFoundError/ImportError, so the model's retry can succeed.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

process.env.GOOBSTER_DB_PATH = path.join(os.tmpdir(), `goobster-sandbox-python-test-${process.pid}.sqlite`);

// These wrapped commands boot heavy voice/music services at load time; the
// registry checks only need the registry itself.
jest.mock('../commands/music/playtrack', () => ({ execute: jest.fn() }));
jest.mock('../commands/chat/speak', () => ({ execute: jest.fn() }));

const { SandboxService } = require('../services/sandboxService');
const sandboxPackages = require('../config/sandboxPackages');

const VENV_PYTHON = path.join(__dirname, '..', 'data', 'sandbox', 'venv', 'bin', 'python');

function makeConfig(overrides = {}) {
    return {
        enabled: true,
        scope: 'everywhere',
        timeoutMs: 15_000,
        maxCpuSeconds: 15,
        maxMemoryMb: 2048,
        maxWriteMb: 16,
        maxOutputBytes: 64 * 1024,
        maxOutputFiles: 8,
        maxFileSizeBytes: 8 * 1024 * 1024,
        runsPerWindow: 100,
        maxConcurrent: 4,
        retentionHours: 24,
        allowNetwork: false,
        pythonCommand: 'python3',
        extraBinds: [],
        pythonBundles: sandboxPackages.bundleNames(),
        extraPythonPackages: [],
        ...overrides
    };
}

describe('config: default interpreter resolution', () => {
    /** Fresh config module with a controlled config.json. */
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

    const venvExists = fs.existsSync(VENV_PYTHON);

    test('explicit env/config always win over auto-detection', () => {
        expect(load({ pythonCommand: '/opt/custom/python' }, { GOOBSTER_SANDBOX_PYTHON: undefined })
            .pythonCommand).toBe('/opt/custom/python');
        expect(load({}, { GOOBSTER_SANDBOX_PYTHON: '/env/python' }).pythonCommand).toBe('/env/python');
    });

    test('with nothing configured, the managed venv is used when present, python3 otherwise', () => {
        const resolved = load({}, { GOOBSTER_SANDBOX_PYTHON: undefined }).pythonCommand;
        if (venvExists) expect(resolved).toBe(VENV_PYTHON);
        else expect(resolved).toBe('python3');
    });

    test('the managed venv location is exported for the setup script and docs', () => {
        expect(load({}, {}).managedVenvPython).toBe(VENV_PYTHON);
    });
});

describe('service: the package probe', () => {
    test('probes real python and returns only curated, importable module names', () => {
        const svc = new SandboxService(makeConfig());
        const mods = svc.listPythonModules();
        expect(Array.isArray(mods)).toBe(true);
        const curated = new Set(sandboxPackages.probeModules());
        for (const mod of mods) expect(curated.has(mod)).toBe(true);
        // Cached: the second call returns the same array without re-probing
        expect(svc.listPythonModules()).toBe(mods);
    });

    test('configured extras are probed alongside the catalog', () => {
        // `json` stands in for an operator-installed package: it is outside
        // the catalog, so seeing it proves extras reach the probe.
        const svc = new SandboxService(makeConfig({
            extraPythonPackages: sandboxPackages.parseExtraPackages(['json'])
        }));
        expect(svc.listPythonModules()).toContain('json');
    });

    test('a broken interpreter degrades to the empty list, never a throw', () => {
        const svc = new SandboxService(makeConfig({ pythonCommand: 'definitely-not-python-xyz' }));
        expect(svc.listPythonModules()).toEqual([]);
    });

    test('the environment note is honest in both directions', () => {
        const bare = new SandboxService(makeConfig());
        bare._pythonModules = [];
        expect(bare.pythonEnvironmentNote()).toMatch(/ONLY the standard library/);
        expect(bare.pythonEnvironmentNote()).toMatch(/sandbox-python/);

        const stocked = new SandboxService(makeConfig());
        stocked._pythonModules = ['numpy', 'matplotlib'];
        expect(stocked.pythonEnvironmentNote()).toContain('numpy, matplotlib');
        expect(stocked.pythonEnvironmentNote()).toMatch(/do not import other packages/);
    });
});

describe('tool surface', () => {
    const toolsRegistry = require('../utils/toolsRegistry');
    const sandboxConfig = require('../config/sandboxConfig');
    const observatoryConfig = require('../config/observatoryConfig');
    const sandboxService = require('../services/sandboxService');
    const original = {
        sandboxEnabled: sandboxConfig.enabled,
        sandboxScope: sandboxConfig.scope,
        obsEnabled: observatoryConfig.enabled,
        obsScope: observatoryConfig.scope,
        pythonModules: sandboxService._pythonModules
    };

    afterEach(() => {
        sandboxConfig.enabled = original.sandboxEnabled;
        sandboxConfig.scope = original.sandboxScope;
        observatoryConfig.enabled = original.obsEnabled;
        observatoryConfig.scope = original.obsScope;
        sandboxService._pythonModules = original.pythonModules;
    });

    test('offered runCode/observatory definitions carry the probed environment note', () => {
        sandboxConfig.enabled = true;
        sandboxConfig.scope = 'everywhere';
        observatoryConfig.enabled = true;
        observatoryConfig.scope = 'everywhere';
        sandboxService._pythonModules = ['numpy', 'scipy'];

        const defs = toolsRegistry.getDefinitions();
        const runCode = defs.find(d => d.name === 'runCode');
        const observatory = defs.find(d => d.name === 'observatory');
        expect(runCode.description).toContain('numpy, scipy');
        expect(observatory.description).toContain('numpy, scipy');
        // Other tools are untouched
        const other = defs.find(d => d.name === 'performSearch');
        expect(other?.description || '').not.toContain('numpy, scipy');
    });

    test('a python run that dies on a missing import gets the environment hint appended', async () => {
        sandboxConfig.enabled = true;
        sandboxConfig.scope = 'everywhere';
        sandboxService._pythonModules = ['numpy'];

        const out = await toolsRegistry.execute('runCode', {
            language: 'python',
            code: 'import definitely_not_installed_xyz',
            interactionContext: { channelId: '123', user: { id: 'py-hint-user' } }
        });
        expect(out).toContain('ModuleNotFoundError');
        expect(out).toContain('💡');
        expect(out).toContain('numpy');
    }, 30_000);

    test('a non-import failure gets no hint', async () => {
        sandboxConfig.enabled = true;
        sandboxConfig.scope = 'everywhere';
        const out = await toolsRegistry.execute('runCode', {
            language: 'python',
            code: 'raise ValueError("nope")',
            interactionContext: { channelId: '123', user: { id: 'py-hint-user' } }
        });
        expect(out).toContain('ValueError');
        expect(out).not.toContain('💡');
    }, 30_000);
});
