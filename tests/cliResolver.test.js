const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveCliCommand, probeCommand } = require('@goobster/core/utils/cliResolver');

// Fake CLIs: small Node scripts run as `node <script> --version` (probeCommand
// appends `--version`, which lands in the script's argv and is ignored).
const node = process.execPath;
let fixtureDir;
let okCli;
let brokenVenvCli;
const missingCli = { cmd: '/definitely/not/a/real/binary-xyz', baseArgs: [] };

const writeFixture = (name, source) => {
    const file = path.join(fixtureDir, name);
    fs.writeFileSync(file, source);
    return { cmd: node, baseArgs: [file] };
};

beforeAll(() => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-resolver-'));
    okCli = writeFixture('ok.js', 'process.exit(0);');
    brokenVenvCli = writeFixture('broken-venv.js', [
        'console.error("Traceback (most recent call last):");',
        'console.error("ModuleNotFoundError: No module named \'spotdl\'");',
        'process.exit(1);'
    ].join('\n'));
});

afterAll(() => {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
});

describe('probeCommand', () => {
    test('reports success for a working candidate', async () => {
        await expect(probeCommand(okCli)).resolves.toEqual({ ok: true });
    });

    test('reports ENOENT as "not found"', async () => {
        const result = await probeCommand(missingCli);
        expect(result.ok).toBe(false);
        expect(result.reason).toBe('not found');
    });

    test('reports non-zero exit with the last stderr line', async () => {
        const result = await probeCommand(brokenVenvCli);
        expect(result.ok).toBe(false);
        expect(result.reason).toBe("exited with code 1: ModuleNotFoundError: No module named 'spotdl'");
    });

    test('truncates an oversized stderr detail', async () => {
        const noisy = writeFixture('noisy.js', 'console.error("x".repeat(500)); process.exit(2);');
        const result = await probeCommand(noisy);
        expect(result.ok).toBe(false);
        expect(result.reason).toMatch(/^exited with code 2: x+\.\.\.$/);
        expect(result.reason.length).toBeLessThan(200);
    });

    test('kills and reports a hung candidate as timed out', async () => {
        const hung = writeFixture('hung.js', 'setTimeout(() => {}, 60000);');
        const result = await probeCommand(hung, { timeoutMs: 500 });
        expect(result.ok).toBe(false);
        expect(result.reason).toMatch(/^timed out after \d+s$/);
    });
});

describe('resolveCliCommand', () => {
    test('returns the first working candidate, skipping failures', async () => {
        const resolved = await resolveCliCommand([missingCli, brokenVenvCli, okCli], {
            name: 'faketool',
            installHint: 'Install it.'
        });
        expect(resolved).toEqual({ cmd: okCli.cmd, baseArgs: okCli.baseArgs });
    });

    test('normalizes a candidate without baseArgs', async () => {
        // A bare `node --version` exits 0.
        const resolved = await resolveCliCommand([{ cmd: node }], {
            name: 'faketool',
            installHint: 'Install it.'
        });
        expect(resolved).toEqual({ cmd: node, baseArgs: [] });
    });

    test('throws with the install hint and a per-candidate diagnostic', async () => {
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        try {
            await expect(resolveCliCommand(
                [
                    { ...missingCli, label: 'config spotdl.path' },
                    brokenVenvCli
                ],
                { name: 'spotdl', installHint: 'Install it with "pip install spotdl".' }
            )).rejects.toThrow(
                /^spotdl CLI not found\. Install it with "pip install spotdl"\. Tried: config spotdl\.path "\/definitely\/not\/a\/real\/binary-xyz" \(not found\); ".+" \(exited with code 1: ModuleNotFoundError: No module named 'spotdl'\)\.$/
            );
            expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('spotdl CLI resolution failed.'));
        } finally {
            errorSpy.mockRestore();
        }
    });
});
