/**
 * Code sandbox service (services/sandboxService.js).
 *
 * Exercises the real executor against python3/bash/node with tiny limits:
 * output capture + truncation, output-file collection (incl. image
 * detection), the wall-clock timeout, the per-user rate limit, the
 * concurrency cap, environment scrubbing (host secrets must never leak in),
 * and the disabled/bad-input gates. Isolation-agnostic: whatever backend the
 * host offers (bwrap / unshare / none), the observable behavior is the same.
 */
const fs = require('node:fs');
const path = require('node:path');
const { SandboxService, SandboxError } = require('../services/sandboxService');

const SANDBOX_ROOT = path.join(__dirname, '..', 'data', 'sandbox', 'runs');

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
        ...overrides
    };
}

afterAll(() => {
    try { fs.rmSync(SANDBOX_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('gates and validation', () => {
    test('run() throws when disabled', async () => {
        const svc = new SandboxService(makeConfig({ enabled: false }));
        expect(svc.enabled).toBe(false);
        await expect(svc.run({ language: 'python', code: 'print(1)' }))
            .rejects.toMatchObject({ name: 'SandboxError', code: 'DISABLED', status: 403 });
    });

    test('rejects unknown language', async () => {
        const svc = new SandboxService(makeConfig());
        await expect(svc.run({ language: 'ruby', code: 'puts 1' }))
            .rejects.toMatchObject({ code: 'BAD_LANGUAGE', status: 400 });
    });

    test('rejects empty code', async () => {
        const svc = new SandboxService(makeConfig());
        await expect(svc.run({ language: 'python', code: '   ' }))
            .rejects.toMatchObject({ code: 'EMPTY_CODE', status: 400 });
    });

    test('language aliases normalize', async () => {
        const svc = new SandboxService(makeConfig());
        const res = await svc.run({ language: 'py', code: 'print("hi")' });
        expect(res.language).toBe('python');
        expect(res.ok).toBe(true);
    });
});

describe('execution', () => {
    test('python: captures stdout and exit 0', async () => {
        const svc = new SandboxService(makeConfig());
        const res = await svc.run({ language: 'python', code: 'print(6 * 7)' });
        expect(res.ok).toBe(true);
        expect(res.exitCode).toBe(0);
        expect(res.timedOut).toBe(false);
        expect(res.stdout.trim()).toBe('42');
        expect(['bwrap', 'unshare', 'none']).toContain(res.isolation);
    });

    test('bash: reads stdin', async () => {
        const svc = new SandboxService(makeConfig());
        const res = await svc.run({ language: 'bash', code: 'read x; echo "got:$x"', stdin: 'hello\n' });
        expect(res.stdout.trim()).toBe('got:hello');
    });

    test('non-zero exit is reported, not thrown', async () => {
        const svc = new SandboxService(makeConfig());
        const res = await svc.run({ language: 'bash', code: 'echo oops >&2; exit 3' });
        expect(res.ok).toBe(false);
        expect(res.exitCode).toBe(3);
        expect(res.stderr).toContain('oops');
    });

    test('collects output files and flags images', async () => {
        const svc = new SandboxService(makeConfig());
        const res = await svc.run({
            language: 'bash',
            code: 'echo hello > notes.txt; printf "PNGDATA" > chart.png'
        });
        expect(res.ok).toBe(true);
        const names = res.files.map(f => f.name).sort();
        expect(names).toEqual(['chart.png', 'notes.txt']);
        const png = res.files.find(f => f.name === 'chart.png');
        const txt = res.files.find(f => f.name === 'notes.txt');
        expect(png.isImage).toBe(true);
        expect(txt.isImage).toBe(false);
        expect(png.size).toBeGreaterThan(0);
        expect(fs.existsSync(png.path)).toBe(true);
    });

    test('the source file is never collected as output', async () => {
        const svc = new SandboxService(makeConfig());
        const res = await svc.run({ language: 'python', code: 'print("noop")' });
        expect(res.files.find(f => f.name === 'main.py')).toBeUndefined();
    });
});

describe('limits', () => {
    test('wall-clock timeout stops a long run', async () => {
        const svc = new SandboxService(makeConfig({ timeoutMs: 1500, maxCpuSeconds: 30 }));
        const res = await svc.run({ language: 'python', code: 'import time; time.sleep(30)' });
        expect(res.timedOut).toBe(true);
        expect(res.ok).toBe(false);
    }, 20_000);

    test('a snippet that ignores SIGTERM is still reported as timed out', async () => {
        // coreutils `timeout -k` escalates to SIGKILL, which can take out the
        // whole process group (`timeout` included) - the run must still be
        // labeled a timeout, not a mystery signal death.
        const svc = new SandboxService(makeConfig({ timeoutMs: 1500, maxCpuSeconds: 30 }));
        const res = await svc.run({
            language: 'python',
            code: 'import signal, time\nsignal.signal(signal.SIGTERM, signal.SIG_IGN)\ntime.sleep(30)'
        });
        expect(res.timedOut).toBe(true);
        expect(res.ok).toBe(false);
    }, 20_000);

    test('stdout is truncated at the byte cap', async () => {
        const svc = new SandboxService(makeConfig({ maxOutputBytes: 256 }));
        const res = await svc.run({ language: 'python', code: 'print("x" * 5000)' });
        expect(res.stdoutTruncated).toBe(true);
        expect(res.stdout.length).toBeLessThan(600);
    });

    test('per-user rate limit trips after the window budget', async () => {
        const svc = new SandboxService(makeConfig({ runsPerWindow: 2 }));
        await svc.run({ language: 'python', code: 'print(1)', userId: 'u1' });
        await svc.run({ language: 'python', code: 'print(2)', userId: 'u1' });
        await expect(svc.run({ language: 'python', code: 'print(3)', userId: 'u1' }))
            .rejects.toMatchObject({ code: 'RATE_LIMITED', status: 429 });
        // A different user is unaffected.
        await expect(svc.run({ language: 'python', code: 'print(4)', userId: 'u2' }))
            .resolves.toMatchObject({ ok: true });
    });

    test('concurrency cap rejects when busy', async () => {
        const svc = new SandboxService(makeConfig({ maxConcurrent: 1 }));
        svc._active = 1; // simulate an in-flight run
        await expect(svc.run({ language: 'python', code: 'print(1)' }))
            .rejects.toMatchObject({ code: 'BUSY', status: 429 });
    });
});

describe('environment scrubbing', () => {
    test('host secrets are not visible to the snippet', async () => {
        process.env.SANDBOX_SECRET_TEST = 'super-secret-value';
        process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-openai-key';
        try {
            const svc = new SandboxService(makeConfig());
            const res = await svc.run({
                language: 'python',
                code: 'import os; print("SECRET=" + repr(os.environ.get("SANDBOX_SECRET_TEST")));'
                    + ' print("OPENAI=" + repr(os.environ.get("OPENAI_API_KEY")))'
            });
            expect(res.stdout).toContain('SECRET=None');
            expect(res.stdout).toContain('OPENAI=None');
            expect(res.stdout).not.toContain('super-secret-value');
        } finally {
            delete process.env.SANDBOX_SECRET_TEST;
        }
    });

    test('matplotlib backend is forced headless', async () => {
        const svc = new SandboxService(makeConfig());
        const res = await svc.run({
            language: 'python',
            code: 'import os; print(os.environ.get("MPLBACKEND"))'
        });
        expect(res.stdout.trim()).toBe('Agg');
    });
});

test('SandboxError is exported', () => {
    expect(new SandboxError(400, 'X', 'msg')).toBeInstanceOf(Error);
});
